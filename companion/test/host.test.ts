import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_MAX_MESSAGE_BYTES } from '@sitecraft/shared';
import type { AgentRequest, AgentScriptOutput, HostInbound, HostOutbound } from '@sitecraft/shared';
import type { AgentHooks, RunAgentFn } from '../src/agent.js';
import { FrameParser, encodeFrame } from '../src/framing.js';
import { startHost, type HostDeps } from '../src/host.js';

const goodScript: AgentScriptOutput = {
  name: 'Hide promo',
  description: 'Hides the promo banner.',
  kind: 'css',
  urlPattern: 'http://localhost:4174/*',
  priority: 3,
  code: '#promo-banner { display: none !important; }',
};

const payload: AgentRequest = {
  request: 'Hide the promo banner',
  page: { url: 'http://localhost:4174/', title: 'Fixture', snapshot: '<html></html>' },
  existingScripts: [],
};

interface Harness {
  stdin: PassThrough;
  stdout: PassThrough;
  received: HostOutbound[];
  send(msg: HostInbound | Record<string, unknown>): void;
  sendRaw(buf: Buffer): void;
  waitFor<T extends HostOutbound>(pred: (m: HostOutbound) => m is T, timeoutMs?: number): Promise<T>;
  waitForAny(pred: (m: HostOutbound) => boolean, timeoutMs?: number): Promise<HostOutbound>;
  stop(): void;
  done: Promise<void>;
}

const active: Harness[] = [];

function makeHost(overrides: Partial<HostDeps> = {}): Harness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const received: HostOutbound[] = [];
  const parser = new FrameParser();
  stdout.on('data', (chunk: Buffer) => {
    for (const m of parser.push(chunk)) received.push(m as HostOutbound);
  });
  const deps: HostDeps = {
    runAgent: async () => goodScript,
    checkLogin: async () => ({ ok: true, detail: 'ok' }),
    version: '0.1.0-test',
    inspectTimeoutMs: 200,
    authTimeoutMs: 200,
    ...overrides,
  };
  const handle = startHost({ stdin, stdout }, deps);
  const waitForAny = (pred: (m: HostOutbound) => boolean, timeoutMs = 2000): Promise<HostOutbound> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const hit = received.find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - started > timeoutMs) {
          return reject(new Error(`timed out waiting for message; got ${JSON.stringify(received)}`));
        }
        setTimeout(tick, 5);
      };
      tick();
    });
  const h: Harness = {
    stdin,
    stdout,
    received,
    send: (msg) => stdin.write(encodeFrame(msg)),
    sendRaw: (buf) => stdin.write(buf),
    waitFor: <T extends HostOutbound>(pred: (m: HostOutbound) => m is T, timeoutMs?: number) =>
      waitForAny(pred, timeoutMs) as Promise<T>,
    waitForAny,
    stop: () => handle.stop(),
    done: handle.done,
  };
  active.push(h);
  return h;
}

afterEach(() => {
  for (const h of active.splice(0)) h.stop();
});

const isType =
  <K extends HostOutbound['type']>(type: K, requestId?: string) =>
  (m: HostOutbound): m is Extract<HostOutbound, { type: K }> =>
    m.type === type && (requestId === undefined || ('requestId' in m && m.requestId === requestId));

describe('startHost', () => {
  it('answers ping with pong', async () => {
    const h = makeHost();
    h.send({ type: 'ping', requestId: 'p1' });
    const pong = await h.waitFor(isType('pong', 'p1'));
    expect(pong).toEqual({ type: 'pong', requestId: 'p1', companionVersion: '0.1.0-test', node: process.version });
  });

  it('answers checkAuth with authResult', async () => {
    const h = makeHost({ checkLogin: async () => ({ ok: false, detail: 'Not logged in' }) });
    h.send({ type: 'checkAuth', requestId: 'a1' });
    const res = await h.waitFor(isType('authResult', 'a1'));
    expect(res).toEqual({ type: 'authResult', requestId: 'a1', ok: false, detail: 'Not logged in' });
  });

  it('turns a checkLogin exception into authResult ok:false', async () => {
    const h = makeHost({
      checkLogin: async () => {
        throw new Error('spawn failed');
      },
    });
    h.send({ type: 'checkAuth', requestId: 'a2' });
    const res = await h.waitFor(isType('authResult', 'a2'));
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('spawn failed');
  });

  it('times out a hanging checkLogin', async () => {
    const h = makeHost({ checkLogin: () => new Promise(() => {}), authTimeoutMs: 50 });
    h.send({ type: 'checkAuth', requestId: 'a3' });
    const res = await h.waitFor(isType('authResult', 'a3'));
    expect(res.ok).toBe(false);
    expect(res.detail.toLowerCase()).toContain('timed out');
  });

  it('runs the agent, relays progress and inspect, and returns the result', async () => {
    const runAgent = vi.fn<RunAgentFn>(async (_payload, hooks) => {
      hooks.onProgress('Agent started');
      const html = await hooks.inspectPage('#x');
      hooks.onProgress(`Got ${html}`);
      return goodScript;
    });
    const h = makeHost({ runAgent });
    h.send({ type: 'run', requestId: 'r1', payload });

    const inspect = await h.waitFor(isType('inspect'));
    expect(inspect.runId).toBe('r1');
    expect(inspect.selector).toBe('#x');
    expect(inspect.requestId).not.toBe('r1');
    expect(typeof inspect.requestId).toBe('string');

    h.send({ type: 'inspectResult', requestId: inspect.requestId, ok: true, html: '<div id="x"></div>' });

    const result = await h.waitFor(isType('result', 'r1'));
    expect(result).toEqual({ type: 'result', requestId: 'r1', ok: true, script: goodScript });

    const progress = h.received.filter(isType('progress', 'r1')).map((p) => p.status);
    expect(progress).toEqual(['Agent started', 'Got <div id="x"></div>']);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0]?.[0]).toEqual(payload);
  });

  it('passes agentOptions through to runAgent', async () => {
    const runAgent = vi.fn<RunAgentFn>(async () => goodScript);
    const h = makeHost({ runAgent, agentOptions: { model: 'test-model', maxTurns: 3 } });
    h.send({ type: 'run', requestId: 'r-opts', payload });
    await h.waitFor(isType('result', 'r-opts'));
    expect(runAgent.mock.calls[0]?.[2]).toMatchObject({ model: 'test-model', maxTurns: 3 });
  });

  it('passes a payload model through to runAgent', async () => {
    const runAgent = vi.fn<RunAgentFn>(async () => goodScript);
    const h = makeHost({ runAgent });
    h.send({ type: 'run', requestId: 'r-model', payload: { ...payload, model: 'claude-fable-5' } });
    await h.waitFor(isType('result', 'r-model'));
    expect(runAgent.mock.calls[0]?.[0]).toMatchObject({ model: 'claude-fable-5' });
  });

  it('rejects inspectPage when the extension reports an inspect error', async () => {
    let inspectError: string | null = null;
    const runAgent: RunAgentFn = async (_p, hooks) => {
      try {
        await hooks.inspectPage('.missing');
      } catch (e) {
        inspectError = (e as Error).message;
      }
      return goodScript;
    };
    const h = makeHost({ runAgent });
    h.send({ type: 'run', requestId: 'r2', payload });
    const inspect = await h.waitFor(isType('inspect'));
    h.send({ type: 'inspectResult', requestId: inspect.requestId, ok: false, error: 'No match' });
    await h.waitFor(isType('result', 'r2'));
    expect(inspectError).toBe('No match');
  });

  it('rejects inspectPage after the inspect timeout', async () => {
    let inspectError: string | null = null;
    const runAgent: RunAgentFn = async (_p, hooks) => {
      try {
        await hooks.inspectPage('#slow');
      } catch (e) {
        inspectError = (e as Error).message;
      }
      return goodScript;
    };
    const h = makeHost({ runAgent, inspectTimeoutMs: 30 });
    h.send({ type: 'run', requestId: 'r3', payload });
    await h.waitFor(isType('inspect'));
    await h.waitFor(isType('result', 'r3'));
    expect(inspectError).toMatch(/timed out/i);
  });

  it('reports a run error as result ok:false', async () => {
    const h = makeHost({
      runAgent: async () => {
        throw new Error('Agent exploded');
      },
    });
    h.send({ type: 'run', requestId: 'r4', payload });
    const result = await h.waitFor(isType('result', 'r4'));
    expect(result).toEqual({ type: 'result', requestId: 'r4', ok: false, error: 'Agent exploded' });
  });

  it('reports a run without a payload as result ok:false', async () => {
    const runAgent = vi.fn<RunAgentFn>(async () => goodScript);
    const h = makeHost({ runAgent });
    h.send({ type: 'run', requestId: 'r5' });
    const result = await h.waitFor(isType('result', 'r5'));
    expect(result.ok).toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('aborts a run on cancel and rejects its pending inspect', async () => {
    let aborted = false;
    let inspectError: string | null = null;
    const runAgent: RunAgentFn = async (_p, hooks: AgentHooks) => {
      hooks.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      try {
        await hooks.inspectPage('#never');
      } catch (e) {
        inspectError = (e as Error).message;
      }
      if (hooks.signal?.aborted) throw new Error('Run cancelled');
      return goodScript;
    };
    const h = makeHost({ runAgent, inspectTimeoutMs: 5000 });
    h.send({ type: 'run', requestId: 'r6', payload });
    await h.waitFor(isType('inspect'));
    h.send({ type: 'cancel', requestId: 'r6' });
    const result = await h.waitFor(isType('result', 'r6'));
    expect(aborted).toBe(true);
    expect(inspectError).toMatch(/cancel/i);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cancel/i);
  });

  it('replaces an oversize result with an error result', async () => {
    const huge: AgentScriptOutput = { ...goodScript, code: 'x'.repeat(NATIVE_MAX_MESSAGE_BYTES) };
    const h = makeHost({ runAgent: async () => huge });
    h.send({ type: 'run', requestId: 'r7', payload });
    const result = await h.waitFor(isType('result', 'r7'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too large/i);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(NATIVE_MAX_MESSAGE_BYTES);
  });

  it('replaces an oversize progress message with a log message', async () => {
    const h = makeHost({
      runAgent: async (_p, hooks) => {
        hooks.onProgress('p'.repeat(NATIVE_MAX_MESSAGE_BYTES));
        return goodScript;
      },
    });
    h.send({ type: 'run', requestId: 'r8', payload });
    await h.waitFor(isType('result', 'r8'));
    expect(h.received.some(isType('progress', 'r8'))).toBe(false);
    const log = h.received.find(isType('log'));
    expect(log).toBeDefined();
    expect(log?.level).toBe('error');
    for (const m of h.received) {
      expect(Buffer.byteLength(JSON.stringify(m))).toBeLessThan(NATIVE_MAX_MESSAGE_BYTES);
    }
  });

  it('survives garbage bytes and bad JSON frames', async () => {
    const h = makeHost();
    h.sendRaw(Buffer.from('hello world garbage that is not a frame!!'));
    await new Promise((r) => setTimeout(r, 10));
    const badJson = Buffer.alloc(4 + 5);
    badJson.writeUInt32LE(5, 0);
    badJson.write('nope!', 4);
    h.sendRaw(badJson);
    await new Promise((r) => setTimeout(r, 10));
    h.send({ type: 'ping', requestId: 'after-garbage' });
    const pong = await h.waitFor(isType('pong', 'after-garbage'));
    expect(pong.companionVersion).toBe('0.1.0-test');
  });

  it('still answers a frame that shares a chunk with trailing garbage', async () => {
    const h = makeHost();
    h.sendRaw(Buffer.concat([encodeFrame({ type: 'ping', requestId: 'same-chunk' }), Buffer.from('garbage!!')]));
    const pong = await h.waitFor(isType('pong', 'same-chunk'));
    expect(pong.requestId).toBe('same-chunk');
    h.send({ type: 'ping', requestId: 'next-chunk' });
    await h.waitFor(isType('pong', 'next-chunk'));
  });

  it('warns about unknown message types and non-object messages, then keeps serving', async () => {
    const h = makeHost();
    h.send({ type: 'explode', requestId: 'u1' });
    h.sendRaw(encodeFrame('just a string'));
    h.sendRaw(encodeFrame(null));
    h.send({ type: 'ping', requestId: 'u2' });
    await h.waitFor(isType('pong', 'u2'));
    const warn = h.received.find((m): m is Extract<HostOutbound, { type: 'log' }> => m.type === 'log' && m.level === 'warn');
    expect(warn?.message).toContain('explode');
  });

  it('ignores inspectResult and cancel for unknown ids', async () => {
    const h = makeHost();
    h.send({ type: 'inspectResult', requestId: 'nope', ok: true, html: '' });
    h.send({ type: 'cancel', requestId: 'nope' });
    h.send({ type: 'ping', requestId: 'i1' });
    const pong = await h.waitFor(isType('pong', 'i1'));
    expect(pong.requestId).toBe('i1');
  });

  it('writes nothing to stdout except frames', async () => {
    const h = makeHost();
    const raw: Buffer[] = [];
    h.stdout.on('data', (c: Buffer) => raw.push(c));
    h.send({ type: 'ping', requestId: 'f1' });
    await h.waitFor(isType('pong', 'f1'));
    const all = Buffer.concat(raw);
    const parser = new FrameParser();
    const frames = parser.push(all);
    expect(frames).toHaveLength(1);
    expect(parser.pending).toBe(0);
  });

  it('resolves done and aborts runs when stdin ends', async () => {
    let aborted = false;
    const h = makeHost({
      runAgent: (_p, hooks) =>
        new Promise((_, reject) => {
          hooks.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    });
    h.send({ type: 'run', requestId: 'end1', payload });
    await new Promise((r) => setTimeout(r, 10));
    h.stdin.end();
    await h.done;
    expect(aborted).toBe(true);
  });

  it('stop() resolves done and ignores later input', async () => {
    const h = makeHost();
    h.stop();
    await h.done;
    h.send({ type: 'ping', requestId: 'late' });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.received).toEqual([]);
  });
});
