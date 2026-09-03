/**
 * Chrome native messaging framing.
 *
 * Every message is a 4-byte native-endian uint32 byte length followed by
 * UTF-8 JSON. Chrome runs little-endian on every platform we support, so
 * we read and write LE explicitly.
 *
 * Limits: the extension may send us up to 64 MiB per message. We may send
 * the extension at most 1 MB per message (see NATIVE_MAX_MESSAGE_BYTES in
 * shared/protocol.ts; the host enforces that separately).
 */

import { errorMessage } from '@sitecraft/shared';

export const HEADER_BYTES = 4;
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** A frame header declared a length above the parser's limit. */
export class FrameTooLargeError extends Error {
  constructor(
    public readonly declared: number,
    public readonly maxBytes: number,
  ) {
    super(`Frame length ${declared} exceeds the limit of ${maxBytes} bytes`);
    this.name = 'FrameTooLargeError';
  }
}

/** A complete frame arrived but its body was not valid JSON. */
export class FrameDecodeError extends Error {
  constructor(
    public readonly raw: Buffer,
    cause: unknown,
  ) {
    super(`Frame body is not valid JSON: ${errorMessage(cause)}`, { cause });
    this.name = 'FrameDecodeError';
  }
}

/** Frame a pre-serialized JSON string. */
export function encodeJsonFrame(json: string): Buffer {
  const body = Buffer.from(json, 'utf8');
  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, HEADER_BYTES);
  return frame;
}

/** Serialize a message as JSON and frame it. */
export function encodeFrame(message: unknown): Buffer {
  return encodeJsonFrame(JSON.stringify(message));
}

export type FrameError = FrameTooLargeError | FrameDecodeError;

export interface FrameParserOptions {
  /** Largest accepted frame body. Default 64 MiB. */
  maxBytes?: number;
  /**
   * Error sink. When set, `push` never throws: a non-JSON frame is reported
   * and skipped, an oversize header is reported and the buffer is dropped,
   * and every message decoded so far is still returned. When not set,
   * `push` throws the same errors instead (see `push` for the details).
   */
  onError?: (error: FrameError) => void;
}

/**
 * Incremental frame decoder. Feed it chunks as they arrive on stdin; it
 * returns every complete message and buffers partial data.
 */
export class FrameParser {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private readonly maxBytes: number;
  private readonly onError: ((error: FrameError) => void) | undefined;

  constructor(options: FrameParserOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.onError = options.onError;
  }

  /** Number of bytes buffered while waiting for a complete frame. */
  get pending(): number {
    return this.buffered;
  }

  /** Drop everything buffered. Use after the stream is known to be out of sync. */
  reset(): void {
    this.chunks = [];
    this.buffered = 0;
  }

  /**
   * Append a chunk and return all complete messages.
   *
   * Without `onError`:
   *  - A header above `maxBytes` throws FrameTooLargeError and drops the
   *    buffer. If messages were already decoded in this call they are
   *    returned first and the throw happens on the next `push`.
   *  - A non-JSON body throws FrameDecodeError after consuming that frame.
   *    Messages decoded earlier in the same call are lost, so callers that
   *    care should pass `onError`.
   */
  push(chunk: Buffer): unknown[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const out: unknown[] = [];
    for (;;) {
      if (this.buffered < HEADER_BYTES) break;
      const head = this.peek(HEADER_BYTES);
      const length = head.readUInt32LE(0);
      if (length > this.maxBytes) {
        if (!this.onError && out.length > 0) break;
        this.reset();
        const error = new FrameTooLargeError(length, this.maxBytes);
        if (this.onError) {
          this.onError(error);
          break;
        }
        throw error;
      }
      if (this.buffered < HEADER_BYTES + length) break;
      this.consume(HEADER_BYTES);
      const body = this.take(length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch (err) {
        const error = new FrameDecodeError(body, err);
        if (this.onError) {
          this.onError(error);
          continue;
        }
        throw error;
      }
      out.push(parsed);
    }
    return out;
  }

  /** Return the first `n` buffered bytes without consuming them. */
  private peek(n: number): Buffer {
    const first = this.chunks[0];
    if (first && first.length >= n) return first.subarray(0, n);
    return Buffer.concat(this.chunks, this.buffered).subarray(0, n);
  }

  /** Remove and return the first `n` buffered bytes. */
  private take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const first = this.chunks[0];
    if (first && first.length >= n) {
      this.consume(n);
      return first.subarray(0, n);
    }
    const all = Buffer.concat(this.chunks, this.buffered);
    const head = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.buffered = rest.length;
    return head;
  }

  /** Discard the first `n` buffered bytes. */
  private consume(n: number): void {
    let remaining = n;
    while (remaining > 0) {
      const first = this.chunks[0];
      if (!first) break;
      if (first.length <= remaining) {
        this.chunks.shift();
        remaining -= first.length;
      } else {
        this.chunks[0] = first.subarray(remaining);
        remaining = 0;
      }
    }
    this.buffered -= n;
  }
}
