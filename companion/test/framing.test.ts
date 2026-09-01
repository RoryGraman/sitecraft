import { describe, expect, it, vi } from 'vitest';
import { FrameDecodeError, FrameParser, FrameTooLargeError, encodeFrame } from '../src/framing.js';

function header(len: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(len, 0);
  return b;
}

describe('encodeFrame', () => {
  it('writes a little-endian uint32 length followed by UTF-8 JSON', () => {
    const frame = encodeFrame({ type: 'ping', requestId: '1' });
    const json = JSON.stringify({ type: 'ping', requestId: '1' });
    expect(frame.readUInt32LE(0)).toBe(Buffer.byteLength(json));
    expect(frame.subarray(4).toString('utf8')).toBe(json);
  });

  it('counts bytes, not characters, for non-ASCII payloads', () => {
    const msg = { text: 'héllo wörld ✓ 日本' };
    const frame = encodeFrame(msg);
    const json = JSON.stringify(msg);
    expect(json.length).toBeLessThan(Buffer.byteLength(json));
    expect(frame.readUInt32LE(0)).toBe(Buffer.byteLength(json));
    expect(frame.length).toBe(4 + Buffer.byteLength(json));
  });
});

describe('FrameParser', () => {
  it('round-trips a single message', () => {
    const parser = new FrameParser();
    const msg = { type: 'run', requestId: 'abc', payload: { n: 1, list: [1, 2, 3] } };
    expect(parser.push(encodeFrame(msg))).toEqual([msg]);
  });

  it('decodes two frames in one chunk', () => {
    const parser = new FrameParser();
    const a = { a: 1 };
    const b = { b: 'two' };
    expect(parser.push(Buffer.concat([encodeFrame(a), encodeFrame(b)]))).toEqual([a, b]);
  });

  it('buffers a frame split across three chunks, including inside the header', () => {
    const parser = new FrameParser();
    const msg = { type: 'ping', requestId: 'split' };
    const frame = encodeFrame(msg);
    expect(parser.push(frame.subarray(0, 2))).toEqual([]);
    expect(parser.push(frame.subarray(2, 9))).toEqual([]);
    expect(parser.push(frame.subarray(9))).toEqual([msg]);
  });

  it('handles a chunk that ends a frame and starts the next one', () => {
    const parser = new FrameParser();
    const a = { first: true };
    const b = { second: true };
    const fa = encodeFrame(a);
    const fb = encodeFrame(b);
    const joined = Buffer.concat([fa, fb]);
    const cut = fa.length + 3;
    expect(parser.push(joined.subarray(0, cut))).toEqual([a]);
    expect(parser.push(joined.subarray(cut))).toEqual([b]);
  });

  it('round-trips an empty object', () => {
    const parser = new FrameParser();
    expect(parser.push(encodeFrame({}))).toEqual([{}]);
  });

  it('round-trips a non-ASCII payload split inside a multi-byte character', () => {
    const parser = new FrameParser();
    const msg = { text: 'héllo ✓ 日本語 🚀' };
    const frame = encodeFrame(msg);
    expect(parser.push(frame.subarray(0, 12))).toEqual([]);
    expect(parser.push(frame.subarray(12))).toEqual([msg]);
  });

  it('throws FrameTooLargeError when the declared length exceeds maxBytes', () => {
    const parser = new FrameParser({ maxBytes: 1024 });
    expect(() => parser.push(header(1025))).toThrow(FrameTooLargeError);
  });

  it('uses a 64 MB default limit', () => {
    const parser = new FrameParser();
    expect(() => parser.push(header(64 * 1024 * 1024 + 1))).toThrow(FrameTooLargeError);
    const ok = new FrameParser();
    expect(ok.push(header(64 * 1024 * 1024))).toEqual([]);
  });

  it('drops its buffer after an oversize header so later frames still decode', () => {
    const parser = new FrameParser({ maxBytes: 1024 });
    expect(() => parser.push(Buffer.from('hello world garbage!!'))).toThrow(FrameTooLargeError);
    expect(parser.pending).toBe(0);
    const msg = { ok: true };
    expect(parser.push(encodeFrame(msg))).toEqual([msg]);
  });

  it('throws FrameDecodeError for a frame that is not JSON and keeps going', () => {
    const parser = new FrameParser();
    const bad = Buffer.concat([header(5), Buffer.from('nope!')]);
    expect(() => parser.push(bad)).toThrow(FrameDecodeError);
    const msg = { after: 1 };
    expect(parser.push(encodeFrame(msg))).toEqual([msg]);
  });

  it('returns frames decoded before an oversize header, then throws on the next push', () => {
    const parser = new FrameParser({ maxBytes: 1024 });
    const good = { good: true };
    expect(parser.push(Buffer.concat([encodeFrame(good), Buffer.from('garbage!!')]))).toEqual([good]);
    expect(() => parser.push(Buffer.alloc(0))).toThrow(FrameTooLargeError);
    expect(parser.pending).toBe(0);
  });

  it('reports bad JSON through onError and returns the other frames', () => {
    const onError = vi.fn();
    const parser = new FrameParser({ onError });
    const bad = Buffer.concat([header(5), Buffer.from('nope!')]);
    const good = { good: true };
    expect(parser.push(Buffer.concat([bad, encodeFrame(good)]))).toEqual([good]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(FrameDecodeError);
  });

  it('reports an oversize header through onError, drops the buffer, and keeps earlier frames', () => {
    const onError = vi.fn();
    const parser = new FrameParser({ maxBytes: 1024, onError });
    const a = { a: 1 };
    const chunk = Buffer.concat([encodeFrame(a), Buffer.from('garbage!!'), encodeFrame({ lost: true })]);
    expect(parser.push(chunk)).toEqual([a]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(FrameTooLargeError);
    expect(parser.pending).toBe(0);
    const b = { b: 2 };
    expect(parser.push(encodeFrame(b))).toEqual([b]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reset() clears buffered partial data', () => {
    const parser = new FrameParser();
    const frame = encodeFrame({ x: 1 });
    parser.push(frame.subarray(0, 6));
    expect(parser.pending).toBe(6);
    parser.reset();
    expect(parser.pending).toBe(0);
    const msg = { y: 2 };
    expect(parser.push(encodeFrame(msg))).toEqual([msg]);
  });
});
